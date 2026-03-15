import React, { useState } from 'react';
import { X, ChevronRight } from 'lucide-react';
import { useApp } from '../context/AppContext';

const SurveyModal = ({ onClose }) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const { user, setUserProfile } = useApp();

  const questions = [
    {
      id: 'stress',
      title: '你最近的主要压力来源是？',
      options: ['学业压力', '人际关系', '未来规划', '经济压力', '家庭期望', '实习压力', '工作压力']
    },
    {
      id: 'coping',
      title: '你通常如何缓解压力？',
      options: ['运动锻炼', '听音乐', '和朋友聊天', '独自思考', '吃东西']
    },
    {
      id: 'sleep',
      title: '你的睡眠质量如何？',
      options: ['很好，7-8小时', '一般，6-7小时', '较差，经常失眠', '不规律']
    },
    {
      id: 'relax',
      title: '你最喜欢的放松方式是？',
      options: ['散步', '看电影', '玩游戏', '读书', '冥想']
    },
    {
      id: 'future',
      title: '你对未来有什么期待？',
      options: ['顺利毕业', '找到好工作', '继续深造', '创业', '环游世界']
    }
  ];

  const handleAnswer = (questionId, answer) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: answer
    }));
  };

  const handleNext = () => {
    if (currentStep < questions.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      // 保存问卷结果（使用用户特定的key）
      localStorage.setItem('surveyCompleted', 'true');
      localStorage.setItem(`surveyAnswers_${user?.userId || 'current_user'}`, JSON.stringify(answers));
      
      // 更新用户资料中的问卷完成状态
      setUserProfile(prev => ({
        ...prev,
        surveyCompleted: true,
        moodProfile: answers
      }));
      
      onClose();
    }
  };

  const currentQuestion = questions[currentStep];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-gray-800">情绪画像问卷</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="mb-4">
          <div className="flex justify-between text-sm text-gray-500 mb-2">
            <span>问题 {currentStep + 1} / {questions.length}</span>
            <span>{Math.round(((currentStep + 1) / questions.length) * 100)}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div 
              className="bg-gradient-to-r from-blue-500 to-purple-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${((currentStep + 1) / questions.length) * 100}%` }}
            />
          </div>
        </div>

        <div className="mb-6">
          <h3 className="text-lg font-medium text-gray-800 mb-4">
            {currentQuestion.title}
          </h3>
          <div className="space-y-3">
            {currentQuestion.options.map((option, index) => (
              <button
                key={index}
                onClick={() => handleAnswer(currentQuestion.id, option)}
                className={`w-full p-3 rounded-lg border-2 text-left transition-all duration-200 ${
                  answers[currentQuestion.id] === option
                    ? 'border-purple-500 bg-purple-50 text-purple-700'
                    : 'border-gray-200 hover:border-purple-300 hover:bg-purple-50'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={handleNext}
          disabled={!answers[currentQuestion.id]}
          className="w-full bg-gradient-to-r from-blue-500 to-purple-500 text-white py-3 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 hover:shadow-lg transition-all duration-200"
        >
          {currentStep === questions.length - 1 ? '完成问卷' : '下一题'}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export default SurveyModal;
